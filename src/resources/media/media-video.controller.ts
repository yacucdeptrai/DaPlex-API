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
  HttpCode,
  Req
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse
} from '@nestjs/swagger';

import { MediaService } from './media.service';
import { MediaVideosService } from './media-videos.service';
import {
  AddMediaVideoDto,
  UpdateMediaVideoDto,
  AddMediaSourceDto,
  SaveMediaSourceDto,
  DeleteMediaVideosDto,
  EncodeMediaSourceDto,
  AddLinkedMediaSourceDto,
  FindMediaStreamsDto
} from './dto';
import { AuthUserDto } from '../users';
import { Media, MediaDetails, MediaUploadSession, MediaVideo, MediaStream } from './entities';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ErrorMessage } from '../auth';
import { HeadersDto } from '../../common/dto';
import { ParseBigIntPipe } from '../../common/pipes';
import { AuthGuardOptions } from '../../decorators/auth-guard-options.decorator';
import { AuthUser } from '../../decorators/auth-user.decorator';
import { RolesGuardOptions } from '../../decorators/roles-guard-options.decorator';
import { RequestHeaders } from '../../decorators/request-headers.decorator';
import { UserPermission } from '../../enums';
import { FastifyRequest } from 'fastify';

@ApiTags('Media')
@ApiExtraModels(Media)
@Controller()
export class MediaVideoController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly mediaVideosService: MediaVideosService
  ) {}

  @Post(':id/videos')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({
    summary: `Add a video (trailer/teaser) to an existing media (permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiCreatedResponse({ description: 'Return added videos', type: [MediaVideo] })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  addMediaVideo(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Body() addMediaVideoDto: AddMediaVideoDto
  ) {
    return this.mediaVideosService.addMediaVideo(id, addMediaVideoDto, headers, authUser);
  }

  @Get(':id/videos')
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({
    summary: `Find all videos in a media (optional auth, optional permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiOkResponse({ description: 'Return a list of videos', type: [MediaVideo] })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'The media is private', type: ErrorMessage })
  findAllMediaVideos(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaVideosService.findAllMediaVideos(id, headers, authUser);
  }

  @Patch(':id/videos/:video_id')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'video_id', type: String })
  @ApiOperation({ summary: `Update a video (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiCreatedResponse({ description: 'Return updated videos', type: [MediaVideo] })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  updateMediaVideo(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('video_id', ParseBigIntPipe) videoId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Body() updateMediaVideoDto: UpdateMediaVideoDto
  ) {
    return this.mediaVideosService.updateMediaVideo(id, videoId, updateMediaVideoDto, headers, authUser);
  }

  @Delete(':id/videos/:video_id')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'video_id', type: String })
  @ApiOperation({ summary: `Delete a video by id (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Video has beed deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media (or the video) could not be found', type: ErrorMessage })
  deleteMediaVideo(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('video_id', ParseBigIntPipe) videoId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaVideosService.deleteMediaVideo(id, videoId, headers, authUser);
  }

  @Delete(':id/videos')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Delete multiple videos (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Videos have beed deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  deleteMediaVideos(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Query() deleteMediaVideosDto: DeleteMediaVideosDto
  ) {
    return this.mediaVideosService.deleteMediaVideos(id, deleteMediaVideosDto, headers, authUser);
  }

  @Post(':id/movie/source')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({
    summary: `Create a session to upload the video source of a movie (permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiCreatedResponse({ description: 'Return upload session id and url', type: MediaUploadSession })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  addMovieSource(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Body() addMediaSourceDto: AddMediaSourceDto
  ) {
    return this.mediaService.uploadMovieSource(id, addMediaSourceDto, authUser);
  }

  @Post(':id/movie/linked-source')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Add a linked movie source (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Source has been queued' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  addLinkedMovieSource(
    @Req() req: FastifyRequest,
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Body() addLinkedMediaSourceDto: AddLinkedMediaSourceDto
  ) {
    const baseUrl = req.protocol + '://' + req.hostname;
    return this.mediaService.addLinkedMovieSource(id, addLinkedMediaSourceDto, baseUrl, authUser);
  }

  @Patch(':id/movie/source')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Encode a movie again from existing source (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Source has been queued' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  encodeMovieSource(
    @Req() req: FastifyRequest,
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Body() encodeMediaSourceDto: EncodeMediaSourceDto
  ) {
    const baseUrl = req.protocol + '://' + req.hostname;
    return this.mediaService.encodeMovieSource(id, encodeMediaSourceDto, baseUrl, authUser);
  }

  @Post(':id/movie/source/:session_id')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'session_id', type: String })
  @ApiOperation({
    summary: `Add a video source from a movie's finished upload session (permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiNoContentResponse({ description: 'Source has been added' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  saveMovieSource(
    @Req() req: FastifyRequest,
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('session_id', ParseBigIntPipe) sessionId: bigint,
    @Body() saveMediaSourceDto: SaveMediaSourceDto
  ) {
    const baseUrl = req.protocol + '://' + req.hostname;
    return this.mediaService.saveMovieSource(id, sessionId, saveMediaSourceDto, baseUrl, authUser);
  }

  @Delete(':id/movie/source')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Delete the source of a movie (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiCreatedResponse({ description: 'The source has been deleted', type: MediaDetails })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  deleteMovieSource(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaService.deleteMovieSource(id, headers, authUser);
  }

  @Get(':id/movie/streams')
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @UseInterceptors(ClassSerializerInterceptor)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: 'Find streams of a movie' })
  @ApiCreatedResponse({ description: 'Return stream data', type: MediaStream })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'The media is private', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  findAllMovieStreams(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Query() findMediaStreamsDto: FindMediaStreamsDto
  ) {
    return this.mediaService.findAllMovieStreams(id, findMediaStreamsDto, authUser);
  }

  @Post(':id/tv/episodes/:episode_id/source')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({
    summary: `Create a session to upload the video source of a tv episode (permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiCreatedResponse({ description: 'Return upload session id and url', type: MediaUploadSession })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  addTVEpisodeSource(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @Body() addMediaSourceDto: AddMediaSourceDto
  ) {
    return this.mediaService.uploadTVEpisodeSource(id, episodeId, addMediaSourceDto, authUser);
  }

  @Post(':id/tv/episodes/:episode_id/linked-source')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({ summary: `Add a linked episode source (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Source has been queued' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  addLinkedTVEpisodeSource(
    @Req() req: FastifyRequest,
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @Body() addLinkedMediaSourceDto: AddLinkedMediaSourceDto
  ) {
    const baseUrl = req.protocol + '://' + req.hostname;
    return this.mediaService.addLinkedTVEpisodeSource(id, episodeId, addLinkedMediaSourceDto, baseUrl, authUser);
  }

  @Patch(':id/tv/episodes/:episode_id/source')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({
    summary: `Encode a tv episode again from existing source (permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiNoContentResponse({ description: 'Source has been queued' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The episode could not be found', type: ErrorMessage })
  encodeTVEpisodeSource(
    @Req() req: FastifyRequest,
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @Body() encodeMediaSourceDto: EncodeMediaSourceDto
  ) {
    const baseUrl = req.protocol + '://' + req.hostname;
    return this.mediaService.encodeTVEpisodeSource(id, episodeId, encodeMediaSourceDto, baseUrl, authUser);
  }

  @Post(':id/tv/episodes/:episode_id/source/:session_id')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiParam({ name: 'session_id', type: String })
  @ApiOperation({
    summary: `Add a video source from a tv episode's finished upload session (permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiNoContentResponse({ description: 'Source has been added' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  saveTVEpisodeSource(
    @Req() req: FastifyRequest,
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @Param('session_id', ParseBigIntPipe) sessionId: bigint,
    @Body() saveMediaSourceDto: SaveMediaSourceDto
  ) {
    const baseUrl = req.protocol + '://' + req.hostname;
    return this.mediaService.saveTVEpisodeSource(id, episodeId, sessionId, saveMediaSourceDto, baseUrl, authUser);
  }

  @Delete(':id/tv/episodes/:episode_id/source')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({ summary: `Delete the source of an episode (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiCreatedResponse({ description: 'The source has been deleted', type: MediaDetails })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  deleteTVEpisodeSource(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaService.deleteTVEpisodeSource(id, episodeId, headers, authUser);
  }

  @Get(':id/tv/episodes/:episode_number/streams')
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @UseInterceptors(ClassSerializerInterceptor)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_number', type: String })
  @ApiOperation({ summary: 'Find streams of an episode' })
  @ApiCreatedResponse({ description: 'Return stream data', type: MediaStream })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'This episode is private', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  findAllTVEpisodeStreams(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_number') episodeNumber: string,
    @Query() findMediaStreamsDto: FindMediaStreamsDto
  ) {
    return this.mediaService.findAllTVEpisodeStreams(id, +episodeNumber, findMediaStreamsDto, authUser);
  }
}
