import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  Delete,
  UseGuards,
  ClassSerializerInterceptor,
  UseInterceptors,
  HttpCode
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse
} from '@nestjs/swagger';

import { MediaService } from './media.service';
import { MediaImagesService } from './media-images.service';
import { MediaTVEpisodesService } from './media-tv-episodes.service';
import { AddTVEpisodeDto, FindTVEpisodesDto, UpdateTVEpisodeDto } from './dto';
import { AuthUserDto } from '../users';
import { Media, MediaDetails, TVEpisode } from './entities';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ErrorMessage } from '../auth';
import { HeadersDto } from '../../common/dto';
import { UploadImageInterceptor } from '../../common/interceptors';
import { ParseBigIntPipe } from '../../common/pipes';
import { AuthGuardOptions } from '../../decorators/auth-guard-options.decorator';
import { AuthUser } from '../../decorators/auth-user.decorator';
import { FileUpload } from '../../decorators/file-upload.decorator';
import { RolesGuardOptions } from '../../decorators/roles-guard-options.decorator';
import { RequestHeaders } from '../../decorators/request-headers.decorator';
import { UserPermission } from '../../enums';
import {
  UPLOAD_MEDIA_IMAGE_TYPES,
  UPLOAD_STILL_MAX_SIZE,
  UPLOAD_STILL_MIN_WIDTH,
  UPLOAD_STILL_MIN_HEIGHT,
  UPLOAD_STILL_RATIO
} from '../../config';

@ApiTags('Media')
@ApiExtraModels(Media)
@Controller()
export class TVEpisodeController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly mediaImagesService: MediaImagesService,
    private readonly mediaTVEpisodesService: MediaTVEpisodesService
  ) {}

  @Post(':id/tv/episodes')
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Add a new episode for a tv show (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiOkResponse({ description: 'Return new episode', type: TVEpisode })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  addTVEpisode(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Body() addTVEpisodeDto: AddTVEpisodeDto
  ) {
    return this.mediaTVEpisodesService.addTVEpisode(id, addTVEpisodeDto, headers, authUser);
  }

  @Get(':id/tv/episodes')
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: 'Find all episodes from a tv show' })
  @ApiOkResponse({ description: 'Return all episodes from a tv show', type: [TVEpisode] })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'The media is private', type: ErrorMessage })
  findAllTVEpisodes(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Query() findEpisodesDto: FindTVEpisodesDto,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaTVEpisodesService.findAllTVEpisodes(id, findEpisodesDto, headers, authUser);
  }

  @Get(':id/tv/episodes/:episode_id')
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({
    summary: `Get details of an episode (optional auth, optional permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiOkResponse({ description: 'Return an episode', type: MediaDetails })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The episode could not be found', type: ErrorMessage })
  findOneTVEpisode(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaTVEpisodesService.findOneTVEpisode(id, episodeId, headers, authUser);
  }

  @Patch(':id/tv/episodes/:episode_id')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({ summary: `Update an episode (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiOkResponse({ description: 'Return updated episode', type: TVEpisode })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  updateTVEpisode(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Body() updateTVEpisodeDto: UpdateTVEpisodeDto
  ) {
    return this.mediaService.updateTVEpisode(id, episodeId, updateTVEpisodeDto, headers, authUser);
  }

  @Delete(':id/tv/episodes/:episode_id')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({ summary: `Delete an episode (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Episode has beed deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  deleteTVEpisode(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaService.deleteTVEpisode(id, episodeId, headers, authUser);
  }

  @Patch(':id/tv/episodes/:episode_id/still')
  @UseGuards(AuthGuard)
  @UseInterceptors(
    new UploadImageInterceptor({
      maxSize: UPLOAD_STILL_MAX_SIZE,
      minWidth: UPLOAD_STILL_MIN_WIDTH,
      minHeight: UPLOAD_STILL_MIN_HEIGHT,
      mimeTypes: UPLOAD_MEDIA_IMAGE_TYPES,
      ratio: UPLOAD_STILL_RATIO,
      autoResize: true
    })
  )
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({
    summary: `Upload episode still image (permissions: ${UserPermission.MANAGE_MEDIA})`,
    description: `Limit: ${UPLOAD_STILL_MAX_SIZE} Bytes<br/>Min resolution: ${UPLOAD_STILL_MIN_WIDTH}x${UPLOAD_STILL_MIN_HEIGHT}<br/>
    Mime types: ${UPLOAD_MEDIA_IMAGE_TYPES.join(', ')}<br/>Aspect ratio: ${UPLOAD_STILL_RATIO.join(':')}`
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOkResponse({ description: 'Return still url' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error.', type: ErrorMessage })
  @ApiUnprocessableEntityResponse({ description: 'Failed to check file type', type: ErrorMessage })
  @ApiUnsupportedMediaTypeResponse({ description: 'Unsupported file', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The user could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiServiceUnavailableResponse({ description: 'Errors from third party API', type: ErrorMessage })
  updateTVEpisodeStill(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @FileUpload() file: Storage.MultipartFile,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaImagesService.uploadTVEpisodeStill(id, episodeId, file, headers, authUser);
  }

  @Delete(':id/tv/episodes/:episode_id/still')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({ summary: `Delete the current episode still image (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Still image has beed deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  deleteTVEpisodeStill(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @FileUpload() file: Storage.MultipartFile,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaImagesService.deleteTVEpisodeStill(id, episodeId, headers, authUser);
  }
}
